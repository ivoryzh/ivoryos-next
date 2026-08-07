import os
import glob

directory = '/Users/ivoryzhang/PycharmProjects/ivoryos-nextgen/edge_server/ivoryos_edge/optimizer'

for filename in glob.glob(os.path.join(directory, '*.py')):
    with open(filename, 'r') as f:
        content = f.read()
    
    new_content = content.replace('ivoryos.optimizer', 'ivoryos_edge.optimizer')
    
    if new_content != content:
        with open(filename, 'w') as f:
            f.write(new_content)
        print(f"Updated {filename}")
